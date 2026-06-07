#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Exportation et publication",
  description: "Comment transformer des notes en productions professionnelles : exportation d'une seule note en PDF, HTML ou Pandoc, PDF/A et PDF/UA accessibles, et exportation d'une collection fusionnée (livre) ou d'un site statique.",
  tags: ("documentation",),
)

= Exportation et publication

== Transformer vos notes en travail fini

Comment transformerez-vous vos notes et votre texte en une production que vous pouvez distribuer ? Prenez les notes que vous avez ébauchées et transformez-les en productions bien conçues et professionnelles que vous pouvez remettre à un lecteur, à un éditeur, à un dépôt ou au Web. InkyCap exporte une seule note à elle seule, mais il peut aussi fusionner toute une #wikilink("2 - Collections", display: "collection") de notes en un seul document soigné (un livre) ou en pages web pour un site.

Vous n'avez besoin de rien connaître de Typst, de la programmation ou de la mise en page pour utiliser cette fonctionnalité. Vous choisissez un format, sélectionnez quelques options en langage clair, et InkyCap produit le fichier.

Il y a deux points de départ, selon ce que vous voulez exporter :

+ *Une note* → la boîte de dialogue *Exporter*.
+ *Une collection entière* (plusieurs notes à la fois, ou fusionnées en livre) → le menu *Exporter* dans la table de la collection. Voir #wikilink("2 - Collections").
\

== Exporter une seule note

=== Ouvrir la boîte de dialogue Exporter

Vous pouvez ouvrir la boîte de dialogue de plusieurs façons :

- Depuis le menu de débordement de la note, choisissez *Exporter...*.
- Depuis la palette de commandes, lancez *Exporter la note en PDF* (cela ouvre la boîte de dialogue déjà réglée sur PDF).
- Depuis la palette de commandes, lancez *Exporter en .typ autonome* (cela ouvre la boîte de dialogue déjà réglée sur le format portable `.typ`).

La boîte de dialogue est une petite fenêtre au centre de l'écran. Appuyez sur *Échap* ou cliquez sur l'arrière-plan pour la fermer. Lorsque vous êtes prêt, cliquez sur *Exporter*.

=== Choisir un format

Le menu déroulant *Format* est divisé en deux groupes.

Le groupe *Typst* ne nécessite aucun logiciel supplémentaire. InkyCap les produit à lui seul :

- *PDF (.pdf)* est le format par défaut. Un document fini, prêt à imprimer.
- *Autonome (.typ)* est une copie portable de la note qui inclut tout ce dont elle a besoin (le package de la boîte de notes et toute image sont copiés à côté). Utile si vous voulez ouvrir ou compiler votre note dans tout autre outil Typst.
- *HTML (.html)* est une page web autonome. Toute image, vidéo ou audio que votre note référence est copiée à côté de la page pour qu'elle fonctionne partout.
- *Markdown (.md)* est une version Markdown en texte brut de la note.

Le groupe *Via Pandoc* produit *OpenDocument (.odt)*, *LaTeX (.tex)*, *Word (.docx)* et *PDF avec propriétés (.pdf)*. Ceux-ci nécessitent l'installation de l'outil gratuit Pandoc (voir #link(<pandoc>)[Travailler avec Pandoc] ci-dessous).

=== Options que vous pourriez voir

Selon le format que vous choisissez, quelques options apparaissent :

- *Métadonnées de la note* (formats PDF, HTML et Pandoc). Choisissez *Exclure les métadonnées* (le défaut) pour garder les #wikilink("6 - Propriétés des notes", display: "propriétés") de votre note hors du fichier, ou *Inclure comme propriétés du document* pour enregistrer le titre, l'auteur, la date et les mots-clés comme les propriétés du document lui-même (de sorte qu'ils apparaissent dans les métadonnées d'un PDF, l'élément `<head>` d'une page web, ou les Propriétés du fichier d'un traitement de texte).
- *Inclure la bibliographie dans la sortie* (PDF et HTML seulement). Activé par défaut. Lorsque c'est activé, votre liste de références apparaît à la fin. Lorsque c'est désactivé, les citations se résolvent quand même normalement, mais la bibliographie rendue est laissée de côté. Voir #wikilink("7 - Citations et bibliographie").
- *Extraire les figures à côté de l'exportation* (tous les formats). Lorsque c'est activé, InkyCap écrit aussi un dossier des images de vos figures à côté de l'exportation.
- *Retirer les liens internes (liens wiki)* (HTML seulement) supprime les liens internes à la note pour que la page se lise comme une prose autonome.
- *Préserver le balisage Typst non convertible (sous forme de blocs de code)* (Markdown seulement). Activé par défaut. Markdown ne peut pas représenter chaque construction Typst, alors tout ce qu'il ne peut pas traduire est enveloppé dans un bloc de code plutôt que perdu. Désactivez-le pour un fichier plus propre si vous ne craignez pas de laisser tomber ces parties.

#callout("tip")[ Les exportations se souviennent de l'endroit où vous en avez enregistré une la dernière fois, alors la prochaine exportation s'ouvre dans le même dossier. La toute première fois, elle démarre dans votre dossier personnel. ]

== Des PDF professionnels et accessibles

Le format PDF offre un menu déroulant *Norme PDF*. C'est là que vous choisissez à quel point le fichier doit être rigoureux et accessible :

- *Standard (PDF 1.7)* est le défaut. Un PDF normal, largement compatible. Choisissez celui-ci pour le partage et l'impression de tous les jours.
- *PDF/A-4 (archivage)* est un format d'archivage à long terme qui convient aux dépôts institutionnels et aux thèses qui doivent rester lisibles pendant des décennies.
- *PDF/UA-1 (accessible)* signifie Accessibilité universelle. Produit un PDF entièrement balisé et structuré que les technologies d'assistance comme les lecteurs d'écran peuvent parcourir.

Vous ne pouvez choisir qu'une seule norme à la fois. Pour les deux normes strictes, InkyCap ajoute automatiquement la date du jour comme date du document si votre note n'en définit pas déjà une (ces formats exigent une date).

#callout("important")[ *PDF/UA-1 refusera d'exporter tant que votre note n'est pas réellement accessible.* Avant de produire le fichier, InkyCap vérifie toute la note et, s'il y a des problèmes, s'arrête et les énumère *tous* en même temps avec les numéros de ligne pour que vous puissiez les corriger d'un seul coup. Les deux choses sur lesquelles il insiste :

- *Chaque image a besoin d'un texte de remplacement* (une courte description de ce que l'image montre, pour qu'un lecteur d'écran puisse le transmettre).
- *Les titres ne doivent pas sauter de niveaux*. Passez d'une section à une sous-section sans sauter un niveau (pas de `=` directement à `===`).

C'est par conception. InkyCap n'inventera pas discrètement une description ni ne masquera un écart, parce qu'un véritable document accessible a besoin d'une véritable structure. ]

#callout("tip", title: "Pour les utilisateurs de Typst")[ L'exigence de texte de remplacement correspond à l'argument `alt:` de chaque `#image(...)`, et la règle des titres veut une imbrication consécutive `=` / `==` / `===`. La vérification préalable (`check_pdf_standard_requirements`) bloque l'exportation et agrège chaque ligne fautive en une seule erreur exploitable ; il n'y a délibérément aucune valeur de repli `alt:` silencieuse. Les normes correspondent à `PdfStandard::A_4` et `PdfStandard::Ua_1` de `typst-pdf`. ]

== Travailler avec Pandoc <pandoc>

Les formats *Via Pandoc* (OpenDocument, LaTeX, Word et PDF-avec-propriétés) reposent sur #link("https://pandoc.org/")[Pandoc], un outil gratuit de conversion de documents que vous installez séparément.

Si InkyCap ne trouve pas Pandoc, la boîte de dialogue affiche *Pandoc introuvable. Installez-le ou définissez un chemin personnalisé dans les Paramètres.* et le bouton Exporter est désactivé jusqu'à ce que vous régliez la situation. Vous pouvez indiquer à InkyCap votre installation de Pandoc dans les #wikilink("2 - Paramètres"), sous les options d'exportation. Là, vous entrez le chemin vers votre binaire Pandoc, ou laissez-le vide pour le détecter automatiquement. Une ligne d'état en direct vous dit s'il a été trouvé.

#callout("note")[ En coulisses, InkyCap rend d'abord votre note en web (HTML) puis laisse Pandoc convertir à partir de là. Cela garde les fonctionnalités de la boîte de notes opérationnelles dans la sortie. Le seul compromis accepté est que les mathématiques complexes peuvent être un brin moins précises par ce chemin que dans un PDF natif. Si votre travail est fortement mathématique, préférez le format natif *PDF (.pdf)*. ]

L'option *PDF avec propriétés (.pdf)* nécessite en plus un moteur PDF (InkyCap en cherche un automatiquement). Si aucun n'est disponible, il vous le dit et vous renvoie à l'exportation PDF native, qui n'a jamais besoin d'outils supplémentaires.

== Le suivi des modifications dans vos exportations

Si votre note porte des suggestions de modifications suivies ou des notes de révision issues d'un travail avec un collaborateur, un menu déroulant *Balisage de révision* apparaît pour que vous puissiez décider comment ces marques se présentent :

- *Conserver les modifications suivies* (le défaut). Les suggestions et les notes de révision apparaissent comme des marques visibles de modifications suivies, tout comme vous les voyez pendant l'édition.
- *Accepter toutes les modifications* applique chaque modification suggérée et retire les notes de révision, vous donnant une copie publiée propre.
- *Rejeter toutes les modifications* écarte les modifications suggérées (le texte original reste) et retire les notes de révision.

InkyCap n'altère jamais discrètement votre contenu : conserver est le défaut partout, et ce contrôle ne s'affiche que pour une seule note lorsque cette note contient réellement du balisage de révision. Voir #wikilink("1 - Collaboration").

== Exporter une collection entière

Une #wikilink("2 - Collections", display: "collection") rassemble plusieurs notes apparentées, et vous pouvez les publier toutes d'un coup. Ouvrez la table de la collection, puis cliquez sur *Exporter* dans sa barre d'outils. Le menu offre :

- *Table en CSV* / *Table en TSV* enregistre la grille de notes de la collection sous forme de fichier de tableur.
- *Collection en fichiers PDF* écrit un PDF par note, dans un dossier que vous choisissez. Si une seule note ne compile pas, InkyCap le signale mais poursuit avec le reste.
- *Collection fusionnée en un seul PDF (livre)* combine chaque note en un seul document bien structuré (voir ci-dessous).
- *Collection en fichiers HTML* publie la collection comme un petit site web (voir ci-dessous).
- *Collection en fichiers Markdown* écrit un fichier Markdown par note.

Le menu porte aussi ses propres menus déroulants *Norme PDF* et *Balisage de révision*, avec les mêmes choix décrits ci-dessus, de sorte que tout le lot suit votre décision. L'ordre des notes dans chaque exportation de collection suit le tri actuel ou l'ordre manuel de la collection.

== Fusionner une collection en un « livre »

*Collection fusionnée en un seul PDF (livre)* est la façon de produire un document professionnel de longue haleine (une thèse, un rapport, un ouvrage collectif) à partir de plusieurs notes. Le résultat peut inclure une page de titre, un résumé, une table des matières, vos chapitres dans l'ordre, et une seule bibliographie.

Vous configurez cela dans les paramètres *Métadonnées du livre* de la collection, qui s'enregistrent automatiquement à mesure que vous les changez. Choix clés :

- *Titre*, *Sous-titre*, *Date* et *Résumé* pour le début du livre.
- *Contributeurs* est une liste de toutes les personnes qui y ont travaillé (couverte ci-dessous).
- *Page de titre* → *Inclure* est activé par défaut. (Si vous avez configuré un template Typst pour la collection, il fournit sa propre page de titre et cette option est masquée.)
- *Table des matières* → *Inclure*, avec un réglage de *Profondeur* et un menu déroulant *Emplacement* :
  - *Début* (défaut) la place dans les pages liminaires, avant le premier chapitre.
  - *Fin* la place après le dernier chapitre, avant la bibliographie.
  - *Après {chapter}* la place juste après un chapitre précis que vous nommez.
- *Titre de chapitre* contrôle si InkyCap fournit le titre supérieur de chaque chapitre à partir du titre de la note, toujours, jamais, ou seulement lorsqu'une note n'a pas le sien.
- *Numérotation des pages* vous laisse choisir le schéma du livre fusionné, comme des chiffres romains pour les pages liminaires suivis de chiffres arabes à partir du chapitre 1, ou des chiffres arabes partout, ou un départ à une page précise.

=== Où va la bibliographie

Le livre fusionné utilise un seul réglage à la fois pour le mode et l'emplacement de la bibliographie : la case à cocher *Inclure une bibliographie unifiée*.

- *Cochée (le défaut)* construit une seule liste de références consolidée à partir du fichier de bibliographie de la collection et la place à la fin. La bibliographie propre à chaque note (si elle est précisée) est supprimée dans la sortie au profit de la consolidée. C'est ce que la plupart des livres veulent.
- *Décochée* garde la bibliographie de chaque note exactement là où son auteur l'a placée.

#callout("warning")[ Un livre fusionné ne peut contenir qu'une seule bibliographie selon les exigences de Typst. Si vous décochez *Inclure une bibliographie unifiée*, alors au plus une note de la collection peut déclarer sa propre bibliographie. Si plus d'une le fait, InkyCap s'arrête avant de compiler et vous le dit, plutôt que de produire un livre brisé.

Une conséquence de cela est que si vous produisez un livre multi-auteurs où chaque chapitre a sa propre bibliographie, celles-ci doivent être incluses comme du texte formaté ordinaire dans le chapitre (et non automatisées). ]

Voir #wikilink("7 - Citations et bibliographie") pour savoir comment fonctionnent les listes de références et les styles de citation.

=== Rendre crédit : la signature et les contributeurs

La liste des *Contributeurs* est la façon dont un livre multi-auteurs obtient une signature et une page de crédits en bonne et due forme. Pour chaque personne, vous pouvez enregistrer :

- son *nom*,
- un *rôle bibliographique*, dont la valeur par défaut est Auteur et qui peut être Éditeur, Traducteur, Illustrateur, et ainsi de suite, et
- un nombre quelconque de *rôles #link("https://casrai.org/credit")[CRediT]* (les quatorze catégories de contribution standard utilisées dans l'édition savante : Conceptualisation, Méthodologie, Rédaction – ébauche originale, Rédaction – révision et édition, et le reste).

À partir de cette liste, InkyCap construit la *signature de la page de titre* (groupée par rôle), enregistre les auteurs dans les métadonnées du document, et (lorsqu'au moins une personne a un rôle CRediT) ajoute un *énoncé de contributions* facultatif sur sa propre page. Vous pouvez désactiver cet énoncé avec l'option *inclure l'énoncé de crédit* ; la signature apparaît toujours dans tous les cas.

=== Lorsqu'une note ne compile pas

Si certaines notes contiennent des erreurs, l'exportation du livre se met en pause avec une boîte de dialogue *Certaines notes ont des erreurs* qui les énumère. Vous pouvez choisir *Continuer (exclure)* pour laisser ces notes de côté et produire le reste du livre, ou *Arrêter et corriger* pour revenir en arrière et les réparer d'abord. (Un problème dans les pages liminaires du livre lui-même est un arrêt complet, puisqu'il n'y aurait rien à construire.)

Le fichier fini porte le nom du titre de votre livre et est enregistré là où vous choisissez.

#callout("tip", title: "Pour les utilisateurs de Typst")[ Les notes sont insérées en ligne dans un seul document synthétique ancré à la racine de la boîte de notes ; par note, l'importation du package, le `#note(...)` initial et (en mode unifié) tout `#bibliography(...)` sont retirés, et les chemins d'image relatifs sont rebasés. Une analyse de collision d'étiquettes bloque l'exportation si vos propres étiquettes sont dupliquées entre les notes (les étiquettes internes `<inkycap-*>` sont exemptées). La signature et l'énoncé CRediT sont rendus par `#contributors-byline(...)` et `#credit-statement(...)` dans le package de la boîte de notes, alors la mise en forme vit dans du Typst modifiable plutôt que dans une sortie codée en dur. ]

== Publier une collection comme site web

*Collection en fichiers HTML* transforme votre collection en un petit site web autonome (un ensemble de pages web interactives que vous pouvez héberger n'importe où). InkyCap produit :

- une page web par note,
- une *page d'index* qui énumère et relie chaque page, et
- une feuille de style avec un design clair en mode clair et sombre qui suit la préférence du système du lecteur.

Les liens wiki entre les notes de la collection deviennent des liens ordinaires cliquables entre les pages, et toute image, vidéo ou audio est copiée dans le site pour que chaque page tienne d'elle-même. Si une note ne compile pas, elle est ignorée et signalée, pour que vous puissiez la corriger et exporter de nouveau. Une page publiée n'est incluse que lorsqu'elle se rend complètement.

== Conception, style et personnalisation

Lorsque vous exportez une collection, InkyCap superpose automatiquement votre mise en style pour que le résultat ait l'air délibéré et cohérent : d'abord vos valeurs par défaut à l'échelle de l'application, puis les *Surcharges de style* propres à la collection (taille du papier, marges, polices, espacement, numérotation des pages et des titres), puis tout template Typst que vous avez choisi pour la collection, et enfin tout ajustement personnalisé. Vous trouvez ces réglages sur la collection elle-même ; voir #wikilink("2 - Collections") et #wikilink("2 - Paramètres").

- Pour *préciser un template Typst à utiliser pour l'exportation de votre collection*, allez à l'onglet `Caractéristiques` de la collection et entrez le nom du template Typst. Vous devez d'abord télécharger/installer le template (voir #wikilink("3 - Scaffolds, Templates et Packages")).
- Utilisez l'onglet `Surcharges de style` de la collection puis cliquez sur le bouton `Avancé` pour injecter votre propre style Typst personnalisé, qui peut surcharger les réglages d'InkyCap.



== Pages connexes

- #wikilink("2 - Collections") : rassembler des notes pour les publier ensemble.
- #wikilink("7 - Citations et bibliographie") : les listes de références et les styles de citation dans votre sortie.
- #wikilink("1 - Collaboration") : le suivi des modifications et leur affichage lors de l'exportation.
- #wikilink("2 - Paramètres") : où définir le chemin de Pandoc et les autres préférences d'exportation.
